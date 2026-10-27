// src/factory/briefRun.js — the brief loop (Plan 7, Task 7): draft → questions → draft … → approve.
// Pure apart from the injected author seat, the io and the project folder. Takes no project lock:
// the CLI handler holds lockProject(dir, 'brief') around this call.
import { callRole } from '../runlog.js';
import { vendorOf } from '../vendors.js';
import { cleanText, validateBrief, renderBrief, briefPaths, nextVersion, saveApprovedBrief, loadBrief, currentBriefInfo } from './brief.js';
import { briefDraftPrompt, parseBriefReply } from './briefPrompts.js';
import { readNotes, saveSession, discardSession } from './briefSession.js';
import { assignExampleIds } from './acceptance.js';

export const BRIEF_LIMITS = Object.freeze({ attempts: 3, rounds: 8, questionsPerRound: 5, answerMax: 2000 });

export function assertFrontierSeat(seat) {
  const candidates = seat?.candidates ?? [seat];
  if (candidates.some((c) => c?.adapter?.kind === 'local-agent' || vendorOf(c?.adapter?.kind) === 'local')) {
    throw new Error('The brief must be written by a frontier model (Claude or Codex): the meeting notes never go to the local model. Check the "author" participants in your config.');
  }
}

const money = (x) => Math.round(x * 1e6) / 1e6;

export async function runBriefSession({ projectDir, session, author, io, log, operatorName, cwd, timeoutMs = 1800000, now = () => new Date() }) {
  assertFrontierSeat(author);
  const slug = session.slug;
  const save = () => saveSession(projectDir, session, { now: now() });
  const end = (status, reason) => ({ status, reason, costUsd: money(session.costUsd) });
  const stopped = () => { save(); return end('stopped', `Stopped. Your answers so far are saved. To carry on, run: conductor brief ${slug}`); };

  // Crash recovery (Ruling P2: before the revise-mode base check): the approved brief was saved
  // but the session was never cleared. Finish without making a second version.
  if (session.approving) {
    const info = currentBriefInfo(projectDir);
    if (info && info.version === session.approving.version) {
      let ok = true;
      try { loadBrief(projectDir); } catch { ok = false; }
      if (ok) {
        const v = info.version;
        discardSession(projectDir);
        const p = briefPaths(projectDir);
        return { status: 'approved', version: v, jsonPath: p.json(v), mdPath: p.md(v), costUsd: money(session.costUsd) };
      }
    }
    session.approving = null;
    save();
  }

  // Ruling 11: every sitting gets fresh budgets. Problems stay, so a fix-its-draft redraft keeps its context.
  session.attempts = 0;
  session.rounds = 0;

  const notes = readNotes(projectDir, session.notes);
  let base = null;
  if (session.mode === 'revise') {
    base = loadBrief(projectDir);
    if (base.version !== session.baseVersion) {
      return end('failed', `The approved brief changed while this revision was open (it is now version ${base.version}). Run conductor brief ${slug} --discard-draft, then start the revision again.`);
    }
  }

  for (;;) {
    if (session.stage === 'draft') {
      if (session.attempts >= BRIEF_LIMITS.attempts) {
        session.attempts = 0;
        save();
        return end('failed', `Conductor could not get a usable brief from the AI after ${BRIEF_LIMITS.attempts} tries. The last problems were: ${session.problems.slice(0, 3).join(' ')} Your answers are saved: run conductor brief ${slug} to try again.`);
      }
      if (session.rounds >= BRIEF_LIMITS.rounds) {
        session.rounds = 0;
        save();
        return end('failed', `The AI still had questions after ${BRIEF_LIMITS.rounds} rounds, so Conductor stopped to save your subscription. Your answers are saved: run conductor brief ${slug} to carry on.`);
      }
      let prompt;
      try {
        prompt = briefDraftPrompt({ notes, baseBrief: base, answers: session.answers, changeRequests: session.changeRequests, problems: session.problems });
      } catch (e) {
        // Too long to send: a refusal for this sitting (the operator splits the notes); retrying cannot help.
        save();
        return end('stopped', String(e?.message ?? e));
      }
      if (session.problems.length) io.say(`Asking the AI to fix its draft (try ${session.attempts + 1} of ${BRIEF_LIMITS.attempts})…`);
      else if (!session.draft && !session.answers.length) io.say('Asking the AI to draft the brief…');
      else io.say('Asking the AI to update the brief with your answers…');

      const r = await callRole(log, author, 'author', prompt, '', { cwd, write: false, timeoutMs });
      const cost = r.usage?.costUsd;
      if (Number.isFinite(cost)) session.costUsd = money(session.costUsd + cost);
      if (!r.ok) {
        if (r.failure === 'no-participant') {
          save();
          return end('paused', `No AI model can write the brief right now (${r.error}). Your answers are saved: run conductor brief ${slug} later.`);
        }
        session.attempts++;
        session.problems = [`the AI could not answer (${r.error})`];
        save();
        continue;
      }
      const parsed = parseBriefReply(r.text);
      if (!parsed.ok) {
        session.attempts++;
        session.problems = [parsed.error];
        save();
        continue;
      }
      const v = validateBrief(parsed.draft, { stage: 'draft' });
      if (!v.ok) {
        session.attempts++;
        session.problems = v.problems;
        save();
        continue;
      }
      session.draft = parsed.draft;
      session.attempts = 0;
      session.problems = [];
      session.changeRequests = [];
      session.rounds++;
      session.pending = (parsed.draft.openQuestions ?? []).slice(0, BRIEF_LIMITS.questionsPerRound);
      session.stage = session.pending.length ? 'questions' : 'approve';
      save();
      continue;
    }

    if (session.stage === 'questions') {
      // Ruling P4: a resumed round numbers the questions still pending from 1.
      const total = session.pending.length;
      const sitting = [];
      let k = 0;
      while (session.pending.length) {
        const q = session.pending[0];
        k++;
        const res = await io.ask({ index: k, total, question: q.question, why: q.why });
        if (!res || res.stop) return stopped();
        const answer = res.skip ? null : (cleanText(res.answer, BRIEF_LIMITS.answerMax) ?? null);
        const entry = { id: q.id, question: q.question, answer, at: now().toISOString() };
        session.answers.push(entry);
        sitting.push({ entry, q });
        session.pending.shift();
        save();
      }
      if (sitting.length && sitting.every((s) => s.entry.answer === null)) {
        session.answers = session.answers.filter((a) => !sitting.some((s) => s.entry === a));
        session.pending = sitting.map((s) => s.q);
        save();
        return end('stopped', `Conductor can't finish the brief until these are answered:\n${sitting.map((s) => `- ${s.q.question}`).join('\n')}\nWhen you know, run: conductor brief ${slug}`);
      }
      session.stage = 'draft';
      save();
      continue;
    }

    // stage 'approve'
    const version = nextVersion(projectDir);
    const stamped = assignExampleIds({ ...session.draft, version }, base);
    const markdown = renderBrief(stamped);
    save();
    const res = await io.approve({ markdown, draftPath: briefPaths(projectDir).draftMd });
    if (res?.decision === 'approve') {
      session.approving = { version };
      save();
      const approved = { ...stamped, schema: 1, slug, version, createdAt: session.startedAt, revisedFrom: session.baseVersion,
        approvedAt: now().toISOString(), approvedBy: operatorName };
      const saved = saveApprovedBrief(projectDir, approved);
      discardSession(projectDir);
      return { status: 'approved', version: saved.version, jsonPath: saved.jsonPath, mdPath: saved.mdPath, costUsd: money(session.costUsd) };
    }
    if (res?.decision === 'change') {
      const note = cleanText(res.note, BRIEF_LIMITS.answerMax);
      if (note) session.changeRequests.push(note);
      session.stage = 'draft';
      save();
      continue;
    }
    return stopped();
  }
}
