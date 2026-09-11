/**
 * 命令注册表·通道域（#169；ADR-0045 裁定：声明按域分文件、单点装配、门在装配表上跑）。
 *
 * 本文件由重构前的两个投递面实测生成，之后**手改会被门打回**——声明的权威是
 * tests/commands.test.ts 的两道对账（工具面快照 + 路由清单/探针快照）。
 */
import { command } from './types.ts'
import type { CommandSpec } from './types.ts'

export const 通道域: CommandSpec[] = [
  command({
    id: "anki-export",
    summary: "Push today's due cards to desktop Anki over AnkiConnect (C2 #63, ADR-0011 — Anki is a pure ANSWERING conduit, the vault stays the ONLY scheduler): recalibrates the mirror deck(s) learnhub::<课程> on every call — adds missing due cards (model「learnhub」, fields 题目/答案/来源, the 来源 field carries 课程/节点/题id for write-back attribution), updates reworded ones, and DELETES mirror cards that are archived, regenerated, or no longer due in the vault (the deck is a disposable mirror — never judged Broken, vault wins on any mismatch; Anki-side scheduling output is discarded). Requires Anki running with the AnkiConnect add-on. After the learner answers in Anki (Again/Hard/Good/Easy), bring the answers home with learnhub_anki_import — import BEFORE the next export so freshly answered cards are not re-pushed.",
    args: {
      endpoint: { type: "string", description: "AnkiConnect endpoint; default http://127.0.0.1:8765" }
    },
    engine: "ankiExportPush",
    domain: "通道",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_anki_export",
        bind: ["endpoint"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/anki/export" }
      }
    ]
  }),
  command({
    id: "anki-import",
    summary: "Pull Anki review events since the last import and write them back as RAW ANSWERING EVIDENCE — the vault re-schedules every affected card with its own ts-fsrs, so the conclusion is identical no matter where the learner answered (ADR-0011: vault is the only scheduler). Mapping: Again → 答错 (rating 1, auto), Hard/Good/Easy → 复习自评档 (2/3/4, self, counted as recalled). The「one push per card per day」invariant holds across devices: a card the vault already advanced that day keeps its schedule untouched — the event is archived in the practice stream only. Imported events land in the practice stream (judge=review, timestamped at the Anki answer time, zero XP) and real advances also land in the review log, so memory-health stats and the FSRS parameter optimizer see Anki answers. Events that cannot be attributed (mirror lost → recovered via the 来源 field; question archived/regenerated) are counted and skipped, never guessed.",
    args: {
      endpoint: { type: "string", description: "AnkiConnect endpoint; default http://127.0.0.1:8765" }
    },
    engine: "ankiImportEvents",
    domain: "通道",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_anki_import",
        bind: ["endpoint"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/anki/import" }
      }
    ]
  }),
  command({
    id: "anki-status",
    summary: "Show the Anki channel status (C2): mirror size and deck names, last push/import timestamps, the current vault due-card distribution the next export would push, and AnkiConnect reachability. Use it to check the channel before exporting or importing.",
    args: {
      endpoint: { type: "string", description: "AnkiConnect endpoint; default http://127.0.0.1:8765" }
    },
    engine: "ankiStatus",
    domain: "通道",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_anki_status",
        bind: ["endpoint"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/anki/status" }
      }
    ]
  }),
  command({
    id: "note-source-exclude",
    summary: "Add a path to the user exclusion list (V-1): a note/folder that batch registrations must never absorb (e.g. private journals, sync-noise folders). Vault-relative or absolute, file or folder (folder = the whole subtree), need not exist yet. Governs FUTURE registrations only — already-registered sources stay until learnhub_note_source_unregister. Current list rides learnhub_note_source_list.",
    args: {
      path: { type: "string", description: "Note or folder path to exclude, vault-relative or absolute; must be outside the learning center", required: true }
    },
    engine: "noteSourceExclude",
    domain: "通道",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_note_source_exclude",
        bind: ["path"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/note-source/exclude" },
        bind: ["path"]
      }
    ]
  }),
  command({
    id: "note-source-generate",
    summary: "Generate review questions for a Note Source (C1): reads the note body (read-only) → 笔记出题 prompt → model → validateBank gate appends each question to the mirror bank (学习中心/笔记源/题库/<id>.yaml) → new cards get their FSRS card initialized (due tomorrow, synthetic init like course completion). The manifest fingerprint refreshes to the current content (drift acknowledged); old questions are NOT auto-archived — offer the learner to archive them explicitly. Fails loud when the source file is missing (re-register first).",
    args: {
      id: { type: "string", description: "Note-source id, e.g. \"note-1\"", required: true },
      count: { type: "number", description: "Question count cap (default 6)" }
    },
    engine: "noteSourceGenerate",
    domain: "通道",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_note_source_generate" },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/note-source/generate" }
      }
    ]
  }),
  command({
    id: "note-source-list",
    summary: "List registered Note Sources (C1) with pool status: ok / missing (note deleted or renamed — pool suspended, re-register or unregister) / drifted (note edited since question generation — regenerate or archive old questions, never automatic). Cards enter the global review queue automatically when due (course field = 笔记源). The response also carries excludes — the user exclusion list (paths never auto-registered; governs future registrations only, existing sources stay).",
    args: {},
    engine: "noteSourceList",
    domain: "通道",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_note_source_list",
        bind: []
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/note-sources" },
        bind: []
      }
    ]
  }),
  command({
    id: "note-source-register",
    summary: "Register a personal vault note (or a folder — batch-registers every .md under it, recursively, dot-dirs skipped) as a Note Source (C1): the engine reads it ONLY to generate review questions; the note file is never written (zero bytes change, never judged Broken). Derivatives (fingerprint manifest + per-source question bank) live in the 学习中心/笔记源 mirror. Re-registering a missing source by the same path restores it. Registrable zones: everything OUTSIDE the learning center, PLUS two learner-document zones inside it (V-3/V-5) — 学习中心/我的产出/** (weekly kata, scripts, error cards) and 学习中心/projects/<id>/日志.md — so learner output can become reviewable too; every other learning-center path is rejected. The user exclusion list (learnhub_note_source_exclude) is enforced at this entry: an excluded input fails loud, and excluded subtrees are batch-skipped — skipped/skipped_paths report everything skipped (excluded entries and any learning-center files; when every .md under the input is skipped the error says so). Question generation is a separate explicit step (learnhub_note_source_generate).",
    args: {
      path: { type: "string", description: "Note or folder path, vault-relative or absolute; must be outside the learning center (except the two learner-document zones), not on the user exclusion list, and must exist", required: true }
    },
    engine: "noteSourceRegister",
    domain: "通道",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_note_source_register",
        bind: ["path"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/note-source/register" },
        bind: ["path"]
      }
    ]
  }),
  command({
    id: "note-source-relink",
    summary: "Relink a Note Source to a new path (V-6 drift governance): when a registered note was RENAMED or MOVED, the source reads Missing and its card pool suspends — relink re-attaches the SAME source id to the new path, keeping the mirror bank and every card's FSRS schedule (unlike unregister+re-register, which orphans the old cards). Fingerprint and title refresh from the new file; the pool-mirror md backlink follows. The new path passes the same hygiene as registration (outside the learning center, not on the user exclusion list, not already taken by another source) and must EXIST — relink is a recovery action. Fails loud on every conflict.",
    args: {
      id: { type: "string", description: "Note-source id, e.g. \"note-1\"", required: true },
      path: { type: "string", description: "New note path (after the rename/move), vault-relative or absolute", required: true }
    },
    engine: "noteSourceRelink",
    domain: "通道",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_note_source_relink",
        bind: ["id", "path"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/note-source/relink" },
        bind: ["id", "path"]
      }
    ]
  }),
  command({
    id: "note-source-unexclude",
    summary: "Remove a path from the user exclusion list (must be on it — fails loud otherwise), making it registrable again via learnhub_note_source_register. Does not auto-register.",
    args: {
      path: { type: "string", description: "Excluded path to release, vault-relative or absolute", required: true }
    },
    engine: "noteSourceUnexclude",
    domain: "通道",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_note_source_unexclude",
        bind: ["path"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/note-source/unexclude" },
        bind: ["path"]
      }
    ]
  }),
  command({
    id: "note-source-unregister",
    summary: "Unregister a Note Source (C1): removes the registry entry, the mirror manifest item, the mirror question bank, and the pool-mirror md. The user's note file is untouched. Use the id from learnhub_note_source_list.",
    args: {
      id: { type: "string", description: "Note-source id, e.g. \"note-1\"", required: true }
    },
    engine: "noteSourceUnregister",
    domain: "通道",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_note_source_unregister",
        bind: ["id"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/note-source/unregister" },
        bind: ["id"]
      }
    ]
  }),
]
