const STORAGE_KEY = 'quizzly.savedQuizzes';
const STUDENTS_KEY = 'quizzly.students';
const PROFILE_KEY = 'quizzly.profile';
const RESULTS_KEY = 'quizzly.quizResults';
const GEMINI_MODEL = 'gemini-3.6-flash';

const app = {
  currentPage: 'dashboard',
  currentQuiz: null,
  quizzes: [],
  results: [],
  shareBaseUrl: '',
  editingQuizId: null,
  previewIndex: 0,
  toastTimer: null,
  sourceDocument: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function showToast(message) {
  $('#toastMessage').textContent = message;
  const toast = $('#toast');
  toast.classList.add('show');
  clearTimeout(app.toastTimer);
  app.toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

function saveStore() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(app.quizzes));
}

function loadStore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function loadStudents() {
  try {
    const saved = JSON.parse(localStorage.getItem(STUDENTS_KEY) || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function loadResults() {
  try {
    const saved = JSON.parse(localStorage.getItem(RESULTS_KEY) || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function loadProfile() {
  try {
    const saved = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}');
    return { firstName: saved.firstName || '', lastName: saved.lastName || '', email: saved.email || '', photo: saved.photo || '' };
  } catch {
    return { firstName: '', lastName: '', email: '', photo: '' };
  }
}

function saveStudents() {
  localStorage.setItem(STUDENTS_KEY, JSON.stringify(app.students));
}

function saveResults() {
  localStorage.setItem(RESULTS_KEY, JSON.stringify(app.results));
}

async function syncQuizToServer(quiz) {
  try {
    await fetch('/api/quizzes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quiz }),
    });
  } catch (error) {
    console.warn('Quiz server sync failed.', error);
  }
}

async function deleteQuizFromServer(id) {
  try {
    await fetch(`/api/quizzes/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (error) {
    console.warn('Quiz delete sync failed.', error);
  }
}

async function syncResultToServer(result) {
  try {
    await fetch('/api/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result }),
    });
  } catch (error) {
    console.warn('Result server sync failed.', error);
  }
}

async function hydrateFromServer() {
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (!response.ok) return;
    const state = await response.json();
    if (state.shareBaseUrl) app.shareBaseUrl = String(state.shareBaseUrl).replace(/\/$/, '');
    const remoteQuizzes = Array.isArray(state.quizzes) ? state.quizzes : [];
    const remoteResults = Array.isArray(state.results) ? state.results : [];
    const quizIds = new Set(app.quizzes.map(quiz => quiz.id));
    const resultIds = new Set(app.results.map(result => result.id));
    app.quizzes = [...app.quizzes, ...remoteQuizzes.filter(quiz => !quizIds.has(quiz.id))];
    app.results = [...app.results, ...remoteResults.filter(result => !resultIds.has(result.id))];
    saveStore();
    saveResults();
    app.quizzes.forEach(quiz => syncQuizToServer(quiz));
    app.results.forEach(result => syncResultToServer(result));
  } catch (error) {
    console.warn('Server state hydration failed.', error);
  }
}

function formatResultDate(value) {
  if (!value) return 'Not yet active';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} hr ago`;
  return new Date(value).toLocaleDateString();
}

function getTrackedStudents() {
  const palette = ['avatar-orange', 'avatar-pink', 'avatar-blue', 'avatar-green', 'avatar-purple', 'avatar-yellow'];
  const groups = new Map();
  app.results.forEach(result => {
    const name = (result.studentName || 'Anonymous student').trim();
    const key = name.toLowerCase();
    if (!groups.has(key)) groups.set(key, { name, results: [] });
    groups.get(key).results.push(result);
  });
  const records = [];
  const addRecord = (name, base = {}) => {
    const key = name.toLowerCase();
    const group = groups.get(key);
    const results = group?.results || [];
    const average = results.length ? Math.round(results.reduce((sum, result) => sum + result.score, 0) / results.length) : (base.avgScore || null);
    records.push({
      ...base,
      name,
      email: group?.results.find(result => result.studentEmail)?.studentEmail || base.email || '',
      initials: base.initials || name.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase(),
      color: base.color || palette[records.length % palette.length],
      quizzesTaken: results.length || base.quizzesTaken || 0,
      avgScore: average,
      lastActive: results.length ? formatResultDate(results[0].completedAt) : (base.lastActive || 'Not yet active'),
    });
  };
  app.students.forEach(student => addRecord(student.name, student));
  groups.forEach(group => {
    if (!records.some(student => student.name.toLowerCase() === group.name.toLowerCase())) addRecord(group.name);
  });
  return records;
}

function recordQuizResult(quiz, studentName, studentEmail, responses, startedAt) {
  const total = quiz.questions.length;
  const correct = quiz.questions.reduce((score, question, index) => {
    const response = responses[index];
    return score + (question.answers?.length && response?.selectedIndex === question.correctIndex ? 1 : 0);
  }, 0);
  const result = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    quizId: quiz.id,
    quizTitle: quiz.title,
    studentName: studentName || 'Anonymous student',
    studentEmail: studentEmail || '',
    correct,
    total,
    score: total ? Math.round((correct / total) * 100) : 0,
    responses,
    durationSeconds: startedAt ? Math.max(1, Math.round((Date.now() - startedAt) / 1000)) : null,
    completedAt: new Date().toISOString(),
  };
  app.results = [result, ...app.results];
  saveResults();
  syncResultToServer(result);
  app.students = loadStudents();
  const existing = app.students.find(student => student.name.toLowerCase() === result.studentName.toLowerCase());
  if (!existing) {
    const initials = result.studentName.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase();
    app.students.unshift({ id: `result-${result.id}`, name: result.studentName, email: result.studentEmail, initials, color: 'avatar-purple', quizzesTaken: 1, avgScore: result.score, lastActive: 'Just now' });
  } else if (result.studentEmail && !existing.email) {
    existing.email = result.studentEmail;
  }
  saveStudents();
  return result;
}

function getStudentResults(studentName) {
  const key = String(studentName || '').trim().toLowerCase();
  return app.results.filter(result => String(result.studentName || '').trim().toLowerCase() === key).sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function getResultMailtoLink(result) {
  const subject = `Quiz result: ${result.quizTitle}`;
  const body = `Hi ${result.studentName},\n\nYour result for ${result.quizTitle}:\nScore: ${result.score}%\nCorrect answers: ${result.correct}/${result.total}\nCompleted: ${new Date(result.completedAt).toLocaleString()}\n\nKeep learning!`;
  return `mailto:${encodeURIComponent(result.studentEmail || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function buildStudentReport(student) {
  const results = getStudentResults(student.name);
  const average = results.length ? Math.round(results.reduce((sum, result) => sum + result.score, 0) / results.length) : 0;
  const accuracy = results.length ? Math.round(results.reduce((sum, result) => sum + result.correct, 0) / Math.max(1, results.reduce((sum, result) => sum + result.total, 0)) * 100) : 0;
  const best = results.length ? Math.max(...results.map(result => result.score)) : 0;
  const latest = results[0]?.completedAt;
  const trend = results.length > 1 ? results[0].score - results[results.length - 1].score : 0;
  const recommendation = !results.length ? 'Complete a first quiz to unlock a performance analysis.' : average >= 85 ? 'Excellent consistency. Try a challenge quiz to extend this progress.' : average >= 60 ? 'Good foundation. Review missed questions and aim for steady improvement.' : 'Schedule a review session and retake a focused practice quiz.';
  return { student, results, average, accuracy, best, latest, trend, recommendation };
}

function reportToText(report) {
  const lines = [
    `Report card — ${report.student.name}`,
    `Email: ${report.student.email || 'Not provided'}`,
    `Quizzes completed: ${report.results.length}`,
    `Average score: ${report.average}%`,
    `Overall accuracy: ${report.accuracy}%`,
    `Best score: ${report.best}%`,
    `Analysis: ${report.recommendation}`,
    '',
    'Quiz results:',
    ...report.results.map(result => `- ${result.quizTitle}: ${result.score}% (${result.correct}/${result.total}) — ${new Date(result.completedAt).toLocaleDateString()}`),
  ];
  return lines.join('\n');
}

function reportToHtml(report) {
  const rows = report.results.map(result => `<tr><td>${escapeHtml(result.quizTitle)}</td><td>${result.score}%</td><td>${result.correct}/${result.total}</td><td>${new Date(result.completedAt).toLocaleDateString()}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(report.student.name)} — Report card</title><style>body{font-family:Arial,sans-serif;color:#26263a;max-width:760px;margin:40px auto;padding:0 24px}h1{margin-bottom:4px}p{color:#6f7080}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:24px 0}.metric{padding:16px;background:#f3f1ff;border-radius:10px}.metric strong{display:block;font-size:25px}.metric span{font-size:12px;color:#707184}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{text-align:left;padding:10px;border-bottom:1px solid #e8e8ef;font-size:13px}th{color:#707184;font-size:11px;text-transform:uppercase} .analysis{padding:14px;background:#f8f8fb;border-radius:10px}</style></head><body><h1>${escapeHtml(report.student.name)} — Report card</h1><p>${escapeHtml(report.student.email || 'No email provided')}</p><div class="metrics"><div class="metric"><strong>${report.average}%</strong><span>Average score</span></div><div class="metric"><strong>${report.accuracy}%</strong><span>Overall accuracy</span></div><div class="metric"><strong>${report.results.length}</strong><span>Quizzes completed</span></div></div><div class="analysis"><strong>Performance analysis</strong><p>${escapeHtml(report.recommendation)}</p></div><table><thead><tr><th>Quiz</th><th>Score</th><th>Correct</th><th>Date</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No quiz results yet.</td></tr>'}</tbody></table></body></html>`;
}

async function requestAutomaticResultEmail(result) {
  if (!result.studentEmail) return { sent: false, reason: 'missing-email' };
  try {
    const response = await fetch('/api/send-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result }),
    });
    const data = await response.json().catch(() => ({}));
    return response.ok ? { sent: true } : { sent: false, reason: data.error?.message || 'Email provider is not configured' };
  } catch {
    return { sent: false, reason: 'Email provider is not configured' };
  }
}

async function sendEmailMessage(message) {
  const response = await fetch('/api/send-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || 'Email provider is not configured');
  return data;
}

function saveProfile() {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(app.profile));
}

const geminiQuizSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'A concise quiz title.' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'Multiple choice, True / false, or Short answer.' },
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          correctAnswer: { type: 'string' },
          explanation: { type: 'string' },
        },
        required: ['type', 'question', 'options', 'correctAnswer', 'explanation'],
      },
    },
  },
  required: ['title', 'questions'],
};

function normalizeGeminiQuestions(payload, quiz) {
  const rawQuestions = Array.isArray(payload.questions) ? payload.questions : [];
  const questions = rawQuestions.slice(0, quiz.questionCount).map((item, index) => {
    const answers = Array.isArray(item.options) ? item.options.filter(Boolean).slice(0, 4) : [];
    const type = item.type === 'True / false' || item.type === 'Short answer' ? item.type : 'Multiple choice';
    const correctIndex = answers.length ? Math.max(0, answers.indexOf(item.correctAnswer)) : null;
    return {
      id: `${index + 1}-${type.toLowerCase().replace(/[^a-z]+/g, '-')}`,
      type,
      difficulty: quiz.difficulty,
      prompt: item.question || `Question ${index + 1} about ${quiz.topic}`,
      answers: type === 'Short answer' ? [] : answers,
      correctIndex,
      explanation: item.explanation || 'Review the lesson material to confirm your answer.',
    };
  });
  while (questions.length < quiz.questionCount) {
    const index = questions.length;
    questions.push(createQuestion(quiz.topic, index, quiz.questionTypes[index % quiz.questionTypes.length], quiz.difficulty));
  }
  return { title: payload.title || quiz.title, questions };
}

async function generateWithGemini(quiz) {
  const sourceInstruction = quiz.sourceText ? ` Use the following uploaded document as the primary source. Base every question on this material and do not invent facts outside it:\n\n${quiz.sourceText.slice(0, 60000)}` : '';
  const prompt = `Create a high-quality classroom quiz about "${quiz.topic}". Audience: students. Difficulty: ${quiz.difficulty}. Generate exactly ${quiz.questionCount} questions and use only these question types: ${quiz.questionTypes.join(', ')}. For multiple choice, provide 4 options and set correctAnswer to exactly match one option. For true/false, provide options ["True", "False"]. For short answer, provide an empty options array and a concise model answer in correctAnswer. Include a short explanation for every answer. Return only JSON matching the provided schema.${sourceInstruction}`;
  const response = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, schema: geminiQuizSchema, temperature: 0.85 }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `Gemini request failed (${response.status})`);
  const text = data.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '';
  if (!text) throw new Error('Gemini returned an empty response');
  let payload;
  try {
    payload = JSON.parse(text.replace(/^```json\s*|\s*```$/g, '').trim());
  } catch {
    throw new Error('Gemini returned invalid quiz JSON');
  }
  return normalizeGeminiQuestions(payload, quiz);
}

function navigate(page) {
  const validPages = ['dashboard', 'students', 'leaderboard', 'quizzes', 'generate', 'analytics', 'settings'];
  const target = validPages.includes(page) ? page : 'dashboard';
  app.currentPage = target;
  $$('.page-view').forEach(view => view.classList.toggle('active', view.dataset.view === target));
  $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.page === target));
  const label = target === 'dashboard' ? 'Dashboard' : target === 'generate' ? 'Generate quiz' : target === 'quizzes' ? 'My quizzes' : target[0].toUpperCase() + target.slice(1);
  $('#breadcrumbCurrent').textContent = label;
  if (location.hash.slice(1) !== target) history.replaceState(null, '', `#${target}`);
  $('#sidebar').classList.remove('mobile-open');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openModal(id) {
  const modal = $(`#${id}`);
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
}

function closeModals() {
  $$('.modal-backdrop').forEach(modal => {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  });
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 42) || 'new-quiz';
}

function buildGeneratedTitle(topic) {
  const clean = topic.trim().replace(/[.!?]+$/, '');
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function getSelectedTypes() {
  return $$('.check-option input:checked').map(input => input.value);
}

function createQuestion(topic, index, type, difficulty) {
  const stems = [
    `What is the most important idea to remember about ${topic}?`,
    `Which statement best explains ${topic}?`,
    `Which example would help a student apply ${topic}?`,
    `Why does ${topic} matter in this lesson?`,
    `Which summary would a teacher most likely use for ${topic}?`,
  ];
  const stem = stems[index % stems.length];
  if (type === 'True / false') {
    return {
      id: `${index + 1}-tf`, type, difficulty,
      prompt: `True or false: ${topic} is a key concept in this quiz.`,
      answers: ['True', 'False'], correctIndex: 0,
      explanation: `${topic} is the focus of this learning check.`,
    };
  }
  if (type === 'Short answer') {
    return {
      id: `${index + 1}-sa`, type, difficulty,
      prompt: `In one or two sentences, explain the central idea behind ${topic}.`,
      answers: [], correctIndex: null,
      explanation: 'A strong answer should name the core idea and explain why it matters.',
    };
  }
  return {
    id: `${index + 1}-mc`, type, difficulty,
    prompt: stem,
    answers: [
      `A core idea connected to ${topic}`,
      'A detail unrelated to the lesson',
      'A conclusion that contradicts the lesson',
      'A topic from a different subject',
    ],
    correctIndex: 0,
    explanation: `The first option is the one directly connected to ${topic}.`,
  };
}

function generateQuestions(topic, count, difficulty, types) {
  return Array.from({ length: count }, (_, index) => createQuestion(topic, index, types[index % types.length], difficulty));
}

function getQuizLink(quiz) {
  const baseUrl = (app.shareBaseUrl || window.location.origin).replace(/\/$/, '');
  return `${baseUrl}/quiz/${slugify(quiz.title)}?id=${encodeURIComponent(quiz.id)}`;
}

function getQuizById(id) {
  return app.quizzes.find(quiz => quiz.id === id) || null;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function getSharedQuizRoute() {
  if (!location.pathname.startsWith('/quiz/')) return null;
  const id = new URLSearchParams(location.search).get('id');
  return { id, quiz: id ? getQuizById(id) : null };
}

async function renderStudentQuizRoute() {
  const route = getSharedQuizRoute();
  if (!route) return false;
  const view = $('#studentQuizView');
  document.body.classList.add('student-mode');
  $('.app-shell').setAttribute('hidden', '');
  view.hidden = false;

  let quiz = route.quiz;
  if (!quiz && route.id) {
    try {
      const response = await fetch(`/api/quizzes/${encodeURIComponent(route.id)}`, { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.quiz?.questions?.length) {
        quiz = data.quiz;
        app.quizzes = [quiz, ...app.quizzes.filter(item => item.id !== quiz.id)];
        saveStore();
      }
    } catch (error) {
      console.warn('Shared quiz lookup failed.', error);
    }
  }

  if (!quiz?.questions?.length) {
    view.innerHTML = `<main class="student-public-page"><div class="student-public-card"><div class="student-brand-mark">✦</div><p class="eyebrow">QUIZ LINK</p><h1>This quiz is unavailable</h1><p class="student-muted">The quiz may have expired or was created in a different browser session.</p><a class="button button-primary" href="/#generate">Create a quiz</a></div></main>`;
    return true;
  }

  const state = { index: 0, selected: null, shortAnswer: '', studentName: '', studentEmail: '', startedAt: Date.now(), responses: [], result: null, submitted: false, emailStatus: '', error: '' };
  const render = () => {
    if (state.submitted) {
      const emailMessage = state.emailStatus === 'sent' ? 'Your result was saved and sent to your email.' : state.emailStatus === 'pending' ? 'Saving your result and preparing your email…' : 'Your result was saved. Automatic email delivery is not configured yet.';
      view.innerHTML = `<main class="student-public-page"><div class="student-public-card student-complete"><div class="student-complete-icon">✓</div><p class="eyebrow">QUIZ SUBMITTED</p><h1>Thanks for completing this quiz.</h1><p class="student-muted">Your response has been recorded.</p><p class="student-email-status">${escapeHtml(emailMessage)}</p><div class="student-result-actions"><a class="button button-secondary" href="${state.result ? escapeHtml(getResultMailtoLink(state.result)) : '#'}">Email my result</a><a class="button button-primary" href="/#dashboard">Done</a></div></div></main>`;
      if (state.result) {
        $('.student-complete h1', view).textContent = `Score: ${state.result.score}%`;
        $('.student-complete .student-muted', view).textContent = `${state.result.correct} of ${state.result.total} answers were correct.`;
      }
      return;
    }
    const question = quiz.questions[state.index];
    const total = quiz.questions.length;
    const isShortAnswer = question.type === 'Short answer' || !question.answers?.length;
    const answers = (question.answers || []).map((answer, answerIndex) => `<button type="button" class="student-answer${state.selected === answerIndex ? ' selected' : ''}" data-answer-index="${answerIndex}"><span>${String.fromCharCode(65 + answerIndex)}</span>${escapeHtml(answer)}</button>`).join('');
    view.innerHTML = `<main class="student-public-page"><header class="student-public-header"><a class="student-brand" href="/#dashboard"><span class="student-brand-mark">✦</span>quizzly</a><span class="student-chip">Student quiz</span></header><section class="student-quiz-card"><p class="eyebrow">${escapeHtml(quiz.difficulty || 'QUIZ')}</p><h1>${escapeHtml(quiz.title)}</h1><p class="student-muted">Enter your details, then answer each question carefully.</p><div class="student-progress-row"><span>Question ${state.index + 1} of ${total}</span><div class="student-progress"><i style="width:${((state.index + 1) / total) * 100}%"></i></div></div><div class="student-identity-grid"><div class="student-name-row"><label for="studentQuizName">Your name</label><input id="studentQuizName" value="${escapeHtml(state.studentName)}" placeholder="Enter your name" autocomplete="name" /></div><div class="student-name-row"><label for="studentQuizEmail">Gmail or email</label><input id="studentQuizEmail" type="email" value="${escapeHtml(state.studentEmail)}" placeholder="student@gmail.com" autocomplete="email" /></div></div><div class="student-question-card"><h2>${escapeHtml(question.prompt)}</h2>${isShortAnswer ? `<textarea id="studentShortAnswer" class="student-short-answer" rows="5" placeholder="Type your answer here...">${escapeHtml(state.shortAnswer)}</textarea>` : `<div class="student-answers">${answers}</div>`}</div><div class="student-question-footer"><span class="student-error">${escapeHtml(state.error)}</span><button type="button" class="button button-primary" data-student-next>${state.index === total - 1 ? 'Submit quiz' : 'Next question'} <span>→</span></button></div></section></main>`;
  };

  view.onclick = event => {
    const answer = event.target.closest('[data-answer-index]');
    if (answer) {
      state.selected = Number(answer.dataset.answerIndex);
      state.error = '';
      render();
      return;
    }
    if (event.target.closest('[data-student-next]')) {
      const question = quiz.questions[state.index];
      const isShortAnswer = question.type === 'Short answer' || !question.answers?.length;
      state.studentName = $('#studentQuizName', view)?.value.trim() || state.studentName;
      state.studentEmail = $('#studentQuizEmail', view)?.value.trim() || state.studentEmail;
      if (!state.studentName) {
        state.error = 'Enter your name before continuing.';
        render();
        return;
      }
      if (!isValidEmail(state.studentEmail)) {
        state.error = 'Enter a valid Gmail or email address to receive your result.';
        render();
        return;
      }
      if (isShortAnswer) state.shortAnswer = $('#studentShortAnswer', view)?.value.trim() || '';
      if ((isShortAnswer && !state.shortAnswer) || (!isShortAnswer && state.selected === null)) {
        state.error = isShortAnswer ? 'Add an answer before continuing.' : 'Choose an answer before continuing.';
        render();
        return;
      }
      state.responses[state.index] = { selectedIndex: isShortAnswer ? null : state.selected, answerText: isShortAnswer ? state.shortAnswer : question.answers[state.selected] };
      if (state.index === quiz.questions.length - 1) {
        state.result = recordQuizResult(quiz, state.studentName, state.studentEmail, state.responses, state.startedAt);
        state.submitted = true;
        state.emailStatus = 'pending';
        requestAutomaticResultEmail(state.result).then(outcome => {
          state.emailStatus = outcome.sent ? 'sent' : 'not-configured';
          render();
        });
      }
      else { state.index += 1; state.selected = null; state.shortAnswer = ''; }
      state.error = '';
      render();
    }
  };
  view.oninput = event => {
    if (event.target.id === 'studentShortAnswer') state.shortAnswer = event.target.value;
    if (event.target.id === 'studentQuizName') state.studentName = event.target.value;
    if (event.target.id === 'studentQuizEmail') state.studentEmail = event.target.value;
  };
  render();
  return true;
}

function createQuizRecord({ status = 'live', questions = [] } = {}) {
  const topic = $('#topic').value.trim() || app.sourceDocument?.name?.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || '';
  if (!$('#topic').value.trim() && topic) $('#topic').value = topic;
  if (!topic) {
    showToast('Tell us what the quiz should be about first');
    $('#topic').focus();
    return null;
  }
  const types = getSelectedTypes();
  if (!types.length) {
    showToast('Select at least one question type');
    return null;
  }
  const count = Number.parseInt($('#questionCount').value, 10) || 10;
  const difficulty = $('#difficulty').value;
  const id = app.editingQuizId || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return {
    id,
    title: buildGeneratedTitle(topic),
    topic,
    difficulty,
    questionCount: count,
    questionTypes: types,
    sourceDocument: app.sourceDocument?.name || '',
    sourceText: app.sourceDocument?.text || '',
    questions: questions.length ? questions : generateQuestions(topic, count, difficulty, types),
    status,
    attempts: 0,
    avgScore: null,
    createdAt: new Date().toISOString(),
  };
}

function saveQuiz(quiz) {
  app.quizzes = [quiz, ...app.quizzes.filter(item => item.id !== quiz.id)];
  saveStore();
  syncQuizToServer(quiz);
  app.currentQuiz = quiz;
  renderQuizLibrary();
  updateNavCount();
}

function openQuizEditor(quiz) {
  if (!quiz) return;
  app.editingQuizId = quiz.id;
  $('#topic').value = quiz.topic || quiz.title;
  $('#questionCount').value = `${quiz.questionCount} questions`;
  $('#difficulty').value = quiz.difficulty || 'Balanced mix';
  $$('.check-option input').forEach(input => {
    input.checked = (quiz.questionTypes || ['Multiple choice', 'True / false']).includes(input.value);
    input.closest('.check-option').classList.toggle('checked', input.checked);
  });
  navigate('generate');
  showToast('Quiz loaded for editing');
}

function updateNavCount() {
  const quizCount = $('.nav-item[data-page="quizzes"] .nav-count');
  const studentCount = $('.nav-item[data-page="students"] .nav-count');
  if (quizCount) quizCount.textContent = String(app.quizzes.length);
  if (studentCount) studentCount.textContent = String(getTrackedStudents().length);
}

function mountQuestionControls() {
  const preview = $('.question-preview');
  if (!preview || $('#questionControls')) return;
  preview.insertAdjacentHTML('beforeend', '<div class="question-controls" id="questionControls"><button class="question-control" id="prevQuestion" type="button">← Previous</button><span id="questionProgress">Question 1 of 10</span><button class="question-control primary" id="nextQuestion" type="button">Next question →</button></div>');
  $('#prevQuestion').addEventListener('click', () => renderQuizPreview(app.currentQuiz, app.previewIndex - 1));
  $('#nextQuestion').addEventListener('click', () => renderQuizPreview(app.currentQuiz, app.previewIndex + 1));
}

function setAvatar(element, initials) {
  if (!element) return;
  element.innerHTML = app.profile.photo ? `<img src="${escapeHtml(app.profile.photo)}" alt="Profile photo" />` : escapeHtml(initials);
  element.classList.toggle('has-photo', Boolean(app.profile.photo));
}

function updateProfileUI() {
  const fullName = [app.profile.firstName, app.profile.lastName].filter(Boolean).join(' ').trim();
  const displayName = fullName || 'Your name';
  const firstName = app.profile.firstName || 'there';
  const initials = fullName ? fullName.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase() : 'YOU';
  $$('.profile-copy strong').forEach(element => { element.textContent = displayName; });
  $$('.profile-copy span').forEach(element => { element.textContent = app.profile.email || 'Add your email'; });
  $('.mini-profile span').textContent = displayName;
  setAvatar($('.mini-profile .avatar'), initials);
  setAvatar($('.profile-row .avatar'), initials);
  setAvatar($('.large-avatar'), initials);
  const greeting = $('#dashboard-page h1');
  if (greeting) greeting.innerHTML = `Good morning, <span class="profile-greeting-name">${firstName}</span> <span class="wave">✦</span>`;
  $('#profileFirstName').value = app.profile.firstName;
  $('#profileLastName').value = app.profile.lastName;
  $('#profileEmail').value = app.profile.email;
}

function renderStudents() {
  const tbody = $('#studentsTable');
  if (!tbody) return;
  const students = getTrackedStudents();
  if (!students.length) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty-table-state"><span class="empty-state-icon">◎</span><strong>No students yet</strong><span>Add your first student to start tracking progress.</span><button class="text-link" data-open-student>Add a student <svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button></div></td></tr>';
  } else {
    tbody.innerHTML = students.map(student => `<tr><td><div class="table-person"><div class="avatar ${student.color || 'avatar-purple'}">${escapeHtml(student.initials)}</div><div><strong>${escapeHtml(student.name)}</strong><span>${escapeHtml(student.email || 'Result recorded from quiz')}</span></div></div></td><td>${student.quizzesTaken || 0}</td><td><strong>${student.avgScore !== null && student.avgScore !== undefined ? `${student.avgScore}%` : '—'}</strong></td><td>${escapeHtml(student.lastActive || 'Not yet active')}</td><td><span class="trend ${student.quizzesTaken ? 'positive' : 'neutral'}">${student.quizzesTaken ? '↗ Results saved' : '— New'}</span></td><td><button class="small-action report-student" data-student-report="${escapeHtml(student.id || student.name)}">Report card</button></td></tr>`).join('');
  }
  const total = $('.stat-card.stat-blue .stat-value');
  const change = $('.stat-card.stat-blue .stat-change');
  if (total) total.textContent = String(students.length);
  if (change) change.innerHTML = students.length ? '<span class="dot"></span> Tracking your class' : '<span class="dot"></span> Add your first student';
  const heading = $('#students-page .page-heading');
  if (heading && ! $('[data-generate-reports]', heading)) heading.insertAdjacentHTML('beforeend', '<button class="button button-secondary" data-generate-reports>Download reports</button>');
  updateNavCount();
  renderActivity();
  renderLeaderboard();
}

function renderPopularQuizzes() {
  const panel = $('.quizzes-panel');
  if (!panel) return;
  const heading = $('.panel-heading', panel);
  $$('.quiz-row', panel).forEach(row => row.remove());
  $('.dashboard-empty-quiz', panel)?.remove();
  const quizStats = app.quizzes.filter(quiz => quiz.status !== 'draft').map(quiz => {
    const results = app.results.filter(result => result.quizId === quiz.id);
    const average = results.length ? Math.round(results.reduce((sum, result) => sum + result.score, 0) / results.length) : 0;
    return { quiz, attempts: results.length, average };
  }).sort((a, b) => b.attempts - a.attempts || b.average - a.average).slice(0, 3);
  if (!quizStats.length) {
    heading.insertAdjacentHTML('afterend', '<div class="dashboard-empty-quiz empty-state compact"><span class="empty-state-icon">✦</span><strong>No live quizzes yet</strong><span>Your saved quizzes will appear here.</span></div>');
    return;
  }
  heading.insertAdjacentHTML('afterend', quizStats.map(({ quiz, attempts, average }, index) => `<div class="quiz-row"><div class="quiz-color ${index === 1 ? 'violet' : index === 2 ? 'orange' : 'blue'}"></div><div class="quiz-title"><strong>${escapeHtml(quiz.title)}</strong><span>${quiz.questions.length} questions · ${attempts} attempts</span></div><div class="quiz-progress"><div class="progress-bar"><i style="width:${average || 0}%"></i></div><span>${attempts ? `${average}% avg.` : 'No results'}</span></div><a class="row-more quiz-open-dashboard" href="${escapeHtml(getQuizLink(quiz))}" aria-label="Open quiz">→</a></div>`).join(''));
}

function renderPerformanceOverview() {
  const summary = $('.chart-summary');
  const mainLine = $('.main-line');
  const areaLine = $('.area-line');
  const pointsGroup = $('.chart-points');
  const ordered = [...app.results].sort((a, b) => new Date(a.completedAt) - new Date(b.completedAt));
  const values = ordered.slice(-7).map(result => Number(result.score) || 0);
  const current = values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
  const previousValues = ordered.slice(Math.max(0, ordered.length - 14), Math.max(0, ordered.length - 7)).map(result => Number(result.score) || 0);
  const previous = previousValues.length ? Math.round(previousValues.reduce((sum, value) => sum + value, 0) / previousValues.length) : 0;
  const change = previousValues.length ? current - previous : 0;
  if (summary) summary.innerHTML = `<div><span class="summary-dot purple"></span><strong>${current}%</strong><span>Current average</span></div><div><span class="summary-dot grey"></span><strong>${previousValues.length ? `${previous}%` : '—'}</strong><span>Previous period</span></div><div class="summary-up ${change < 0 ? 'negative' : ''}">${previousValues.length ? `${change >= 0 ? '↑' : '↓'} ${Math.abs(change)}%` : '—'} <span>${previousValues.length ? 'change' : 'Waiting for more results'}</span></div>`;
  if (!mainLine || !areaLine || !pointsGroup) return;
  const chartValues = values.length ? values : [0];
  const coords = chartValues.map((value, index) => {
    const x = chartValues.length === 1 ? 340 : (index * 680) / (chartValues.length - 1);
    const y = 190 - Math.max(0, Math.min(100, value)) * 1.6;
    return [x, y];
  });
  const path = coords.map(([x, y], index) => `${index ? 'L' : 'M'}${x} ${y}`).join(' ');
  mainLine.setAttribute('d', path);
  areaLine.setAttribute('d', `${path} L680 220 L0 220 Z`);
  pointsGroup.innerHTML = coords.map(([x, y]) => `<circle cx="${x}" cy="${y}"/>`).join('');
}

function renderClassroomStreak() {
  const panel = $('.streak-panel');
  if (!panel) return;
  const dayKey = value => {
    const date = new Date(value);
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  };
  const days = new Set(app.results.map(result => dayKey(result.completedAt)));
  const ordered = [...app.results].sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
  let streak = 0;
  if (ordered.length) {
    const cursor = new Date(ordered[0].completedAt);
    while (days.has(dayKey(cursor))) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
  }
  $('.streak-panel>strong').textContent = `${streak} day${streak === 1 ? '' : 's'}`;
  $('.streak-panel p').innerHTML = app.results.length ? 'Your class is building momentum.<br/>Keep the learning going!' : 'Student submissions will build your streak.<br/>Start with a quiz today!';
  const week = $('.week-dots');
  if (week) {
    const today = new Date();
    const labels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    week.innerHTML = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(today);
      date.setDate(today.getDate() - (6 - index));
      const done = days.has(dayKey(date));
      const isToday = index === 6;
      return `<span class="${done ? 'done ' : ''}${isToday ? 'today' : ''}">${labels[date.getDay()]}</span>`;
    }).join('');
  }
}

function renderAnalytics() {
  const results = app.results;
  const students = getTrackedStudents();
  const durationResults = results.filter(result => result.durationSeconds);
  const averageDuration = durationResults.length ? Math.round(durationResults.reduce((sum, result) => sum + result.durationSeconds, 0) / durationResults.length) : 0;
  const accuracy = results.length ? Math.round(results.reduce((sum, result) => sum + result.correct, 0) / Math.max(1, results.reduce((sum, result) => sum + result.total, 0)) * 100) : 0;
  const atRisk = students.filter(student => student.avgScore !== null && student.avgScore < 60).length;
  const activeStudents = new Set(results.map(result => String(result.studentName || '').toLowerCase())).size;
  const completion = students.length ? Math.round(activeStudents / students.length * 100) : 0;
  const cards = $$('#analytics-page .stat-card');
  if (cards[0]) $('.stat-value', cards[0]).textContent = averageDuration ? `${Math.floor(averageDuration / 60)}m ${averageDuration % 60}s` : '—';
  if (cards[1]) $('.stat-value', cards[1]).innerHTML = `${accuracy}<span class="stat-unit">%</span>`;
  if (cards[2]) $('.stat-value', cards[2]).textContent = String(atRisk);
  if (cards[3]) $('.stat-value', cards[3]).innerHTML = `${completion}<span class="stat-unit">%</span>`;
  const groups = new Map();
  results.forEach(result => {
    if (!groups.has(result.quizId)) groups.set(result.quizId, { title: result.quizTitle, scores: [] });
    groups.get(result.quizId).scores.push(result.score);
  });
  const strongest = [...groups.values()].sort((a, b) => (b.scores.reduce((x, y) => x + y, 0) / b.scores.length) - (a.scores.reduce((x, y) => x + y, 0) / a.scores.length))[0];
  const calloutTitle = $('.analytics-callout h2');
  const calloutText = $('.analytics-callout p');
  if (calloutTitle) calloutTitle.textContent = strongest ? `Your class is strongest in ${strongest.title}` : 'Your class analytics are waiting';
  if (calloutText) calloutText.textContent = strongest ? `Students are averaging ${Math.round(strongest.scores.reduce((sum, score) => sum + score, 0) / strongest.scores.length)}% on this quiz. Use the report cards to share progress and plan the next lesson.` : 'Analytics will update automatically after students submit their first quiz.';
}

function renderActivity() {
  const list = $('.activity-list');
  const completedCard = $('.stat-card.stat-violet .stat-value');
  const averageCard = $('.stat-card.stat-yellow .stat-value');
  const activeCard = $('.stat-card.stat-green .stat-value');
  if (completedCard) completedCard.textContent = app.results.length.toLocaleString();
  if (averageCard) {
    const average = app.results.length ? Math.round(app.results.reduce((sum, result) => sum + result.score, 0) / app.results.length) : 0;
    averageCard.innerHTML = `${average}<span class="stat-unit">%</span>`;
  }
  if (activeCard) activeCard.textContent = String(app.quizzes.filter(quiz => quiz.status !== 'draft').length);
  if (list) {
    if (app.results.length) {
      list.innerHTML = app.results.slice(0, 5).map(result => `<div class="activity-item"><div class="avatar avatar-purple">${escapeHtml((result.studentName || 'AS').split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase())}</div><div class="activity-info"><strong>${escapeHtml(result.studentName)}</strong><span>${escapeHtml(result.quizTitle)} · ${result.correct}/${result.total} correct${result.studentEmail ? ` · ${escapeHtml(result.studentEmail)}` : ''}</span></div><span class="activity-status">${result.score}%</span></div>`).join('');
    } else if (!app.students.length) {
      list.innerHTML = '<div class="empty-state compact"><span class="empty-state-icon">◎</span><strong>No recent activity</strong><span>Student submissions will appear here after you add your class.</span></div>';
    } else {
      list.innerHTML = app.students.slice(0, 5).map(student => `<div class="activity-item"><div class="avatar ${student.color || 'avatar-purple'}">${student.initials}</div><div class="activity-info"><strong>${escapeHtml(student.name)}</strong><span>Ready for their first quiz</span></div><span class="activity-status">New student</span></div>`).join('');
    }
  }
  renderPopularQuizzes();
  renderPerformanceOverview();
  renderClassroomStreak();
  renderAnalytics();
}

function renderLeaderboard() {
  const podium = $('.podium');
  const rankingPanel = $('.full-ranking');
  if (!podium || !rankingPanel) return;
  const students = getTrackedStudents();
  $$('.ranking-row', rankingPanel).forEach(row => row.remove());
  $('.ranking-empty', rankingPanel)?.remove();
  $('.full-ranking .panel-heading p').textContent = students.length ? 'Keep climbing — you are doing great.' : 'Add students to start your weekly ranking.';
  const totalPoints = students.reduce((sum, student) => sum + (student.avgScore || 0), 0);
  $('.points-pill').textContent = students.length ? `🏆 ${totalPoints} total pts` : '🏆 0 total pts';
  if (!students.length) {
    podium.innerHTML = '<div class="empty-state compact"><span class="empty-state-icon">🏆</span><strong>No rankings yet</strong><span>Add students to start the leaderboard.</span></div>';
    rankingPanel.insertAdjacentHTML('beforeend', '<div class="empty-state compact ranking-empty"><span class="empty-state-icon">✦</span><strong>Your class leaderboard is waiting</strong><span>Quiz results will appear here once students start completing quizzes.</span></div>');
    return;
  }
  const ranked = [...students].sort((a, b) => (b.avgScore || 0) - (a.avgScore || 0));
  podium.innerHTML = ranked.slice(0, 3).map((student, index) => `<div class="podium-person ${index === 0 ? 'first' : index === 1 ? 'second' : 'third'}"><div class="podium-avatar-wrap"><div class="avatar ${student.color || 'avatar-purple'}">${student.initials}</div><span class="rank-badge">${index + 1}</span></div><strong>${student.name.split(' ')[0]}</strong><span>${student.avgScore || 0} pts</span><div class="podium-block ${index === 0 ? 'block-one' : index === 1 ? 'block-two' : 'block-three'}">${index + 1}</div></div>`).join('');
  ranked.forEach((student, index) => rankingPanel.insertAdjacentHTML('beforeend', `<div class="ranking-row"><span class="ranking-number">${index + 1}</span><div class="avatar ${student.color || 'avatar-purple'}">${student.initials}</div><div class="ranking-name"><strong>${student.name}</strong><span>${student.quizzesTaken || 0} quizzes completed</span></div><div class="ranking-score"><strong>${student.avgScore || 0}</strong><span>points</span></div><span class="ranking-change">—</span></div>`));
}

function openReportModal(studentId) {
  const student = getTrackedStudents().find(item => String(item.id) === String(studentId) || item.name === studentId);
  if (!student) return;
  const report = buildStudentReport(student);
  app.activeReport = report;
  $('#reportTitle').textContent = `${student.name}'s report card`;
  $('#reportSubtitle').textContent = student.email || 'Add an email address to send this report directly.';
  $('#reportBody').innerHTML = `<div class="report-metrics"><div><strong>${report.average}%</strong><span>Average score</span></div><div><strong>${report.accuracy}%</strong><span>Accuracy</span></div><div><strong>${report.results.length}</strong><span>Quizzes</span></div></div><div class="report-analysis"><strong>Performance analysis</strong><p>${escapeHtml(report.recommendation)}</p></div><div class="report-results">${report.results.length ? report.results.map(result => `<div><span>${escapeHtml(result.quizTitle)}</span><strong>${result.score}% <small>${result.correct}/${result.total}</small></strong></div>`).join('') : '<div class="report-empty">No quiz results yet.</div>'}</div>`;
  openModal('reportModal');
}

function downloadActiveReport() {
  if (!app.activeReport) return;
  const blob = new Blob([reportToHtml(app.activeReport)], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${slugify(app.activeReport.student.name)}-report-card.html`;
  link.click();
  URL.revokeObjectURL(url);
  showToast('Report card downloaded');
}

async function emailActiveReport() {
  if (!app.activeReport) return;
  if (!app.activeReport.student.email) {
    showToast('Add the student email before emailing this report');
    return;
  }
  const subject = `Report card: ${app.activeReport.student.name}`;
  try {
    await sendEmailMessage({ to: app.activeReport.student.email, subject, text: reportToText(app.activeReport), html: reportToHtml(app.activeReport) });
    showToast('Report card sent successfully');
  } catch {
    window.location.href = `mailto:${encodeURIComponent(app.activeReport.student.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(reportToText(app.activeReport))}`;
    showToast('Email provider is not configured; a draft was prepared');
  }
}

function downloadAllReports() {
  const reports = getTrackedStudents().map(buildStudentReport);
  if (!reports.length) {
    showToast('Add students or collect a quiz result first');
    return;
  }
  const sections = reports.map(report => `<section><h2>${escapeHtml(report.student.name)}</h2><p>${escapeHtml(report.student.email || 'No email provided')}</p><div class="metrics"><div class="metric"><strong>${report.average}%</strong><span>Average score</span></div><div class="metric"><strong>${report.accuracy}%</strong><span>Accuracy</span></div><div class="metric"><strong>${report.results.length}</strong><span>Quizzes completed</span></div></div><div class="analysis"><strong>Performance analysis</strong><p>${escapeHtml(report.recommendation)}</p></div><table><thead><tr><th>Quiz</th><th>Score</th><th>Correct</th><th>Date</th></tr></thead><tbody>${report.results.map(result => `<tr><td>${escapeHtml(result.quizTitle)}</td><td>${result.score}%</td><td>${result.correct}/${result.total}</td><td>${new Date(result.completedAt).toLocaleDateString()}</td></tr>`).join('') || '<tr><td colspan="4">No quiz results yet.</td></tr>'}</tbody></table></section>`).join('<hr>');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Class report cards</title><style>body{font-family:Arial,sans-serif;color:#26263a;max-width:820px;margin:40px auto;padding:0 24px}h1{margin-bottom:30px}h2{margin-top:28px}p{color:#6f7080}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:16px 0}.metric{padding:14px;background:#f3f1ff;border-radius:10px}.metric strong{display:block;font-size:23px}.metric span{font-size:11px;color:#707184}.analysis{padding:14px;background:#f8f8fb;border-radius:10px}.analysis p{margin-bottom:0}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{text-align:left;padding:9px;border-bottom:1px solid #e8e8ef;font-size:12px}th{color:#707184;font-size:10px;text-transform:uppercase}hr{border:0;border-top:1px solid #ddd;margin:35px 0}</style></head><body><h1>Class report cards</h1>${sections}</body></html>`;
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'class-report-cards.html';
  link.click();
  URL.revokeObjectURL(url);
  showToast(`${reports.length} report card${reports.length === 1 ? '' : 's'} downloaded`);
}

function openStudentModal() {
  $('#studentName').value = '';
  $('#studentEmail').value = '';
  $('#studentCohort').value = '';
  openModal('studentModal');
  $('#studentName').focus();
}

function saveStudent() {
  const name = $('#studentName').value.trim();
  if (!name) {
    $('#studentName').focus();
    showToast('Enter the student name first');
    return;
  }
  const palette = ['avatar-orange', 'avatar-pink', 'avatar-blue', 'avatar-green', 'avatar-purple', 'avatar-yellow'];
  const initials = name.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase();
  const student = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, name, email: $('#studentEmail').value.trim(), cohort: $('#studentCohort').value.trim(), initials, color: palette[app.students.length % palette.length], quizzesTaken: 0, avgScore: null, lastActive: 'Not yet active' };
  app.students = [student, ...app.students];
  saveStudents();
  renderStudents();
  closeModals();
  showToast(`${name} added to your class`);
}

function renderQuizPreview(quiz, index = app.previewIndex) {
  if (!quiz) return;
  app.currentQuiz = quiz;
  const total = quiz.questions.length || quiz.questionCount;
  app.previewIndex = Math.min(Math.max(index, 0), Math.max(total - 1, 0));
  $('#modalTitle').textContent = quiz.title;
  $('.generated-meta').innerHTML = `<span>${total} questions</span><span>•</span><span>${quiz.difficulty}</span><span>•</span><span>${Math.max(5, Math.ceil(total * 0.8))} min estimated</span>`;
  const question = quiz.questions[app.previewIndex] || createQuestion(quiz.topic, app.previewIndex, quiz.questionTypes?.[app.previewIndex % (quiz.questionTypes?.length || 1)] || 'Multiple choice', quiz.difficulty);
  $('.question-number').textContent = `${String(app.previewIndex + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`;
  $('.question-preview h3').textContent = question.prompt;
  const answerWrap = $('.question-preview');
  $$('.answer-preview', answerWrap).forEach(answer => answer.remove());
  if (!question.answers.length) {
    answerWrap.insertAdjacentHTML('beforeend', '<div class="answer-preview"><span>✎</span> Written response — students explain in their own words.</div>');
  } else {
    question.answers.forEach((answer, answerIndex) => {
      const letter = String.fromCharCode(65 + answerIndex);
      const correct = answerIndex === question.correctIndex ? ' correct' : '';
      const mark = answerIndex === question.correctIndex ? '<b>✓</b>' : '';
      answerWrap.insertAdjacentHTML('beforeend', `<div class="answer-preview${correct}"><span>${letter}</span> ${answer}${mark}</div>`);
    });
  }
  mountQuestionControls();
  $('#questionProgress').textContent = `Question ${app.previewIndex + 1} of ${total}`;
  $('#prevQuestion').disabled = app.previewIndex === 0;
  $('#nextQuestion').disabled = app.previewIndex >= total - 1;
}

function libraryCard(quiz) {
  const colors = ['library-blue', 'library-purple', 'library-orange'];
  const color = colors[app.quizzes.indexOf(quiz) % colors.length];
  const symbol = color === 'library-blue' ? '✦' : color === 'library-purple' ? '∿' : '◌';
  const status = quiz.status === 'draft' ? '<span class="status-draft"><i></i> Draft</span>' : '<span class="status-live"><i></i> Live</span>';
  const action = quiz.status === 'draft' ? `<button class="small-action edit-draft" data-quiz-id="${quiz.id}">Continue editing</button>` : `<a class="small-action open-quiz-link" href="${getQuizLink(quiz)}">Open quiz</a><button class="small-action share-existing" data-quiz-id="${quiz.id}">Share link</button>`;
  return `<article class="library-card generated-library-card"><div class="library-color ${color}"><span>${symbol}</span></div><div class="library-content"><div class="library-meta">${status}<button class="row-more quiz-menu-trigger" aria-label="More options" data-quiz-menu-trigger="${quiz.id}"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button><div class="quiz-menu" data-quiz-menu="${quiz.id}" hidden><button type="button" data-quiz-action="edit" data-quiz-id="${quiz.id}">Edit quiz</button><button type="button" data-quiz-action="share" data-quiz-id="${quiz.id}">Share link</button><button type="button" class="danger" data-quiz-action="delete" data-quiz-id="${quiz.id}">Delete quiz</button></div></div><h3>${escapeHtml(quiz.title)}</h3><p>${quiz.questionCount} questions · ${quiz.status === 'draft' ? 'Not published' : 'Ready to share'}</p><div class="library-footer"><span>${quiz.status === 'draft' ? 'Saved locally' : 'Avg. score'} <strong>${quiz.avgScore ? `${quiz.avgScore}%` : quiz.status === 'draft' ? 'Draft' : 'New'}</strong></span>${action}</div></div></article>`;
}

function renderQuizLibrary() {
  const library = $('#quizLibrary');
  if (!library) return;
  $$('.generated-library-card', library).forEach(card => card.remove());
  $$('.empty-library-state', library).forEach(state => state.remove());
  $$('.library-card:not(.new-library-card)', library).forEach(card => card.remove());
  if (app.quizzes.length) {
    library.insertAdjacentHTML('afterbegin', app.quizzes.map(libraryCard).join(''));
  } else {
    library.insertAdjacentHTML('afterbegin', '<div class="empty-library-state empty-state compact"><span class="empty-state-icon">✦</span><strong>No saved quizzes yet</strong><span>Generate your first quiz and save it here.</span></div>');
  }
}

function openShareModal(quiz) {
  if (!quiz) {
    quiz = { id: 'sample-7f3k', title: 'My quiz', topic: 'My quiz', questionCount: 10, questions: [], difficulty: 'Balanced mix' };
  }
  app.currentQuiz = quiz;
  const link = getQuizLink(quiz);
  $('#shareLink').textContent = link.replace(/^https?:\/\//, '');
  $('#shareLink').href = link;
  $('#shareEmail').value = '';
  $('#shareNote').textContent = 'You can add multiple email addresses separated by commas.';
  openModal('shareModal');
}

function bindNavigation() {
  $$('[data-page], [data-navigate]').forEach(link => link.addEventListener('click', event => {
    event.preventDefault();
    const target = link.dataset.page || link.dataset.navigate;
    if (target === 'generate') app.editingQuizId = null;
    navigate(target);
  }));
  window.addEventListener('hashchange', () => navigate(location.hash.slice(1) || 'dashboard'));
  window.addEventListener('storage', event => {
    if (event.key === RESULTS_KEY || event.key === STUDENTS_KEY) {
      app.results = loadResults();
      app.students = loadStudents();
      renderStudents();
    }
  });
}

function bindSidebar() {
  $('#sidebarToggle').addEventListener('click', () => {
    $('#sidebar').classList.toggle('collapsed');
    $('.main-content').classList.toggle('sidebar-collapsed');
  });
  $('#mobileMenu').addEventListener('click', () => $('#sidebar').classList.toggle('mobile-open'));
  document.addEventListener('click', event => {
    const sidebar = $('#sidebar');
    if (window.innerWidth <= 760 && sidebar.classList.contains('mobile-open') && !sidebar.contains(event.target) && !$('#mobileMenu').contains(event.target)) sidebar.classList.remove('mobile-open');
  });
}

function loadExternalScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) { existing.addEventListener('load', resolve, { once: true }); existing.addEventListener('error', reject, { once: true }); return; }
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Document parser could not be loaded'));
    document.head.appendChild(script);
  });
}

async function extractDocumentText(file) {
  const extension = file.name.split('.').pop().toLowerCase();
  if (['txt', 'md', 'csv', 'text'].includes(extension)) return file.text();
  if (extension === 'pdf') {
    await loadExternalScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map(item => item.str).join(' '));
    }
    return pages.join('\n\n');
  }
  if (extension === 'docx') {
    await loadExternalScript('https://unpkg.com/mammoth@1.8.0/mammoth.browser.min.js');
    const result = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value;
  }
  throw new Error('Use a PDF, DOCX, TXT, Markdown, or CSV file.');
}

function mountDocumentUpload() {
  const form = $('.generator-form-panel');
  const topicSection = $('.generator-form-panel .form-section');
  if (!form || !topicSection || $('#documentSource')) return;
  topicSection.insertAdjacentHTML('afterend', `<div class="document-source" id="documentSource"><div class="document-source-copy"><span class="document-source-icon">↑</span><div><strong>Use a document as your source</strong><small>Upload a PDF, DOCX, TXT, Markdown, or CSV file.</small></div></div><label class="document-upload-button" for="documentInput">Choose file<input id="documentInput" type="file" accept=".pdf,.docx,.txt,.md,.csv,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden></label><div class="document-file" id="documentFile" hidden></div></div>`);
  $('#documentInput').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    const fileStatus = $('#documentFile');
    fileStatus.hidden = false;
    fileStatus.textContent = `Reading ${file.name}…`;
    try {
      const text = (await extractDocumentText(file)).replace(/\s+/g, ' ').trim();
      if (!text) throw new Error('No readable text was found in this file.');
      app.sourceDocument = { name: file.name, text };
      fileStatus.innerHTML = `<span>✓ ${escapeHtml(file.name)} · ${text.length.toLocaleString()} characters</span><button type="button" id="removeDocument">Remove</button>`;
      $('#removeDocument').addEventListener('click', () => { app.sourceDocument = null; $('#documentInput').value = ''; fileStatus.hidden = true; });
      showToast('Document added as the quiz source');
    } catch (error) {
      app.sourceDocument = null;
      fileStatus.hidden = true;
      showToast(error.message || 'Could not read that document');
    }
  });
}

function bindGenerator() {
  mountDocumentUpload();
  $$('.suggestion').forEach(button => button.addEventListener('click', () => {
    $('#topic').value = button.dataset.topic;
    $('#topic').focus();
  }));
  $$('.check-option input').forEach(checkbox => checkbox.addEventListener('change', () => {
    checkbox.closest('.check-option').classList.toggle('checked', checkbox.checked);
  }));
  $('#saveDraft').addEventListener('click', () => {
    const draft = createQuizRecord({ status: 'draft', questions: [] });
    if (!draft) return;
    saveQuiz(draft);
    app.editingQuizId = null;
    showToast('Draft saved locally');
    navigate('quizzes');
  });
  $('#generateButton').addEventListener('click', async () => {
    const button = $('#generateButton');
    const quiz = createQuizRecord();
    if (!quiz) return;
    button.disabled = true;
    button.innerHTML = '<span class="loading-spinner"></span> Asking Gemini...';
    try {
      const generated = await generateWithGemini(quiz);
      quiz.title = generated.title;
      quiz.questions = generated.questions;
      quiz.questionCount = generated.questions.length || quiz.questionCount;
    } catch (error) {
      console.warn('Gemini generation failed.', error);
      quiz.questions = generateQuestions(quiz.topic, quiz.questionCount, quiz.difficulty, quiz.questionTypes);
      quiz.title = buildGeneratedTitle(quiz.topic);
      button.disabled = false;
      button.innerHTML = '<span class="button-sparkle">✦</span> Generate quiz';
      renderQuizPreview(quiz);
      openModal('quizModal');
      showToast(`Gemini is temporarily unavailable. Created a local ${quiz.questions.length}-question draft.`);
      return;
    }
    renderQuizPreview(quiz);
    button.disabled = false;
    button.innerHTML = '<span class="button-sparkle">✦</span> Generate quiz';
    openModal('quizModal');
    showToast(`${quiz.questions.length} questions generated with Gemini AI`);
  });
}

function bindModals() {
  $$('[data-close-modal]').forEach(button => button.addEventListener('click', closeModals));
  $$('.modal-backdrop').forEach(backdrop => backdrop.addEventListener('click', event => {
    if (event.target === backdrop) closeModals();
  }));
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeModals(); });
  $('#saveStudent').addEventListener('click', saveStudent);
  $('#reviewQuiz').addEventListener('click', () => {
    if (!app.currentQuiz) return;
    app.currentQuiz.status = 'live';
    saveQuiz(app.currentQuiz);
    app.editingQuizId = null;
    closeModals();
    navigate('quizzes');
    showToast('Quiz saved to My quizzes');
  });
  $('#shareFromReview').addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    openShareModal(app.currentQuiz);
  });
  $('#copyLink').addEventListener('click', async () => {
    const link = getQuizLink(app.currentQuiz || { id: 'sample-7f3k', title: 'My quiz' });
    $('#shareLink').textContent = link.replace(/^https?:\/\//, '');
    $('#shareLink').href = link;
    try { await navigator.clipboard.writeText(link); } catch { /* clipboard may be unavailable in local previews */ }
    showToast('Link copied to clipboard');
  });
  $('#sendLink').addEventListener('click', async () => {
    const email = $('#shareEmail').value.trim();
    if (!email || !email.split(',').every(item => isValidEmail(item.trim()))) {
      $('#shareEmail').focus();
      showToast('Add valid student email addresses first');
      return;
    }
    const recipients = email.split(',').map(item => item.trim()).filter(Boolean);
    const quiz = app.currentQuiz;
    const link = quiz ? getQuizLink(quiz) : window.location.href;
    const button = $('#sendLink');
    button.disabled = true;
    try {
      await Promise.all(recipients.map(to => sendEmailMessage({
        to,
        subject: `Quiz invitation: ${quiz?.title || 'Quizzly quiz'}`,
        text: `You have been invited to take ${quiz?.title || 'a Quizzly quiz'}. Open this link: ${link}`,
        html: `<p>You have been invited to take <strong>${escapeHtml(quiz?.title || 'a Quizzly quiz')}</strong>.</p><p><a href="${escapeHtml(link)}">Open the quiz</a></p>`,
      })));
      if (quiz) { quiz.lastSharedAt = new Date().toISOString(); saveStore(); syncQuizToServer(quiz); }
      $('#shareEmail').value = '';
      $('#shareNote').textContent = `Sent to ${recipients.length} student${recipients.length === 1 ? '' : 's'} ✦`;
      showToast('Quiz email sent successfully');
    } catch (error) {
      $('#shareNote').textContent = 'Email provider is not configured. Add Gmail SMTP or Resend settings on the server.';
      showToast(error.message || 'Email could not be sent');
    } finally {
      button.disabled = false;
    }
  });
  $('#downloadReport').addEventListener('click', downloadActiveReport);
  $('#emailReport').addEventListener('click', emailActiveReport);
  document.addEventListener('click', event => {
    const menuTrigger = event.target.closest('[data-quiz-menu-trigger]');
    if (menuTrigger) {
      event.stopPropagation();
      const menu = $(`[data-quiz-menu="${menuTrigger.dataset.quizMenuTrigger}"]`);
      $$('.quiz-menu').forEach(item => { if (item !== menu) item.hidden = true; });
      if (menu) menu.hidden = !menu.hidden;
      return;
    }
    const quizAction = event.target.closest('[data-quiz-action]');
    if (quizAction) {
      const quiz = getQuizById(quizAction.dataset.quizId);
      $$('.quiz-menu').forEach(item => { item.hidden = true; });
      if (!quiz) return;
      if (quizAction.dataset.quizAction === 'edit') {
        openQuizEditor(quiz);
        return;
      }
      if (quizAction.dataset.quizAction === 'share') {
        openShareModal(quiz);
        return;
      }
      if (quizAction.dataset.quizAction === 'delete') {
        if (!window.confirm(`Delete "${quiz.title}"? This cannot be undone.`)) return;
        app.quizzes = app.quizzes.filter(item => item.id !== quiz.id);
        saveStore();
        deleteQuizFromServer(quiz.id);
        renderQuizLibrary();
        updateNavCount();
        showToast('Quiz deleted');
        return;
      }
    }
    const addStudentButton = event.target.closest('[data-open-student]') || (event.target.closest('button') && event.target.closest('button').textContent.trim() === 'Add students');
    if (addStudentButton) openStudentModal();
    const reportButton = event.target.closest('[data-student-report]');
    if (reportButton) openReportModal(reportButton.dataset.studentReport);
    const reportsButton = event.target.closest('[data-generate-reports]');
    if (reportsButton) downloadAllReports();
    const shareButton = event.target.closest('.share-existing');
    if (shareButton) {
      const card = shareButton.closest('.library-card');
      const title = $('h3', card)?.textContent || 'My quiz';
      openShareModal(getQuizById(shareButton.dataset.quizId) || { id: 'sample-7f3k', title, topic: title, questionCount: 10, questions: [], difficulty: 'Balanced mix' });
    }
    const editButton = event.target.closest('.edit-draft');
    if (editButton) {
      const draft = getQuizById(editButton.dataset.quizId);
      openQuizEditor(draft);
    }
  });
}

function bindSearch() {
  $('#studentSearch').addEventListener('input', event => {
    const query = event.target.value.toLowerCase();
    $$('#studentsTable tr').forEach(row => row.style.display = row.textContent.toLowerCase().includes(query) ? '' : 'none');
  });
}

function bindSettings() {
  $('#changePhoto').addEventListener('click', () => $('#profilePhotoInput').click());
  $('#profilePhotoInput').addEventListener('change', event => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      app.profile.photo = String(reader.result || '');
      saveProfile();
      updateProfileUI();
      showToast('Profile photo saved');
    };
    reader.readAsDataURL(file);
  });
  $('#saveSettings').addEventListener('click', () => {
    const firstName = $('#profileFirstName').value.trim();
    const lastName = $('#profileLastName').value.trim();
    if (!firstName) {
      $('#profileFirstName').focus();
      showToast('Enter your first name first');
      return;
    }
    app.profile = { firstName, lastName, email: $('#profileEmail').value.trim(), photo: app.profile.photo || '' };
    saveProfile();
    updateProfileUI();
    showToast('Your profile was updated');
  });
}

async function init() {
  sessionStorage.removeItem('quizzly.geminiApiKey');
  app.profile = loadProfile();
  app.students = loadStudents();
  app.results = loadResults();
  app.quizzes = loadStore();
  await hydrateFromServer();
  $('#reviewQuiz').innerHTML = 'Save quiz <svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  bindNavigation();
  bindSidebar();
  bindGenerator();
  bindModals();
  bindSearch();
  bindSettings();
  updateProfileUI();
  renderStudents();
  renderQuizLibrary();
  updateNavCount();
  if (await renderStudentQuizRoute()) return;
  navigate(location.hash.slice(1) || 'dashboard');
}

init();
