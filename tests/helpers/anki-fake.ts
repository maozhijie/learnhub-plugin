/** 假 AnkiConnect（内存态牌组/笔记/复习日志，cardReviews 按毫秒水位过滤）；
 * 从 anki.test.ts 抽出共享（#295 幂等回归也消费）。 */
import type { AnkiTransport } from '../../src/engine/anki.ts'

export class FakeAnki implements AnkiTransport {
  notes = new Map<number, { noteId: number; deckName: string; fields: Record<string, string>; tags: string[] }>()
  cards = new Map<number, number>()
  reviews: number[][] = []
  models = new Set<string>()
  decks = new Set<string>()
  private nextNoteId = 1_700_000_000_000
  private nextCardId = 1_800_000_000_000

  async invoke(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    switch (action) {
      case 'version': return 6
      case 'modelNames': return [...this.models]
      case 'createModel': this.models.add(String(params.modelName)); return null
      case 'deckNames': return [...this.decks]
      case 'createDeck': this.decks.add(String(params.deck)); return null
      case 'addNote': {
        const note = params.note as { deckName: string; fields: Record<string, string>; tags: string[] }
        for (const n of this.notes.values()) {
          if (n.deckName === note.deckName && n.fields['来源'] === note.fields['来源']) return null
        }
        if (!this.models.has('learnhub')) throw new Error('Model not found')
        const id = this.nextNoteId++
        this.notes.set(id, { noteId: id, deckName: note.deckName, fields: { ...note.fields }, tags: [...note.tags] })
        const cardId = this.nextCardId++
        this.cards.set(cardId, id)
        return id
      }
      case 'updateNoteFields': {
        const n = this.notes.get(Number((params.note as { id: number }).id))
        if (!n) throw new Error('Note not found')
        Object.assign(n.fields, (params.note as { fields: Record<string, string> }).fields)
        return null
      }
      case 'deleteNotes':
        for (const id of params.notes as number[]) this.notes.delete(Number(id))
        return null
      case 'findNotes': {
        const deck = /deck:"([^"]+)"/.exec(String(params.query))?.[1]
        return [...this.notes.values()].filter(n => !deck || n.deckName === deck).map(n => n.noteId)
      }
      case 'notesInfo':
        return (params.notes as number[]).map(id => {
          const n = this.notes.get(Number(id))
          if (!n) return null
          return { noteId: n.noteId, fields: Object.fromEntries(Object.entries(n.fields).map(([k, v]) => [k, { value: v }])) }
        }).filter(Boolean)
      case 'cardsInfo':
        return (params.cards as number[]).map(id => {
          const noteId = this.cards.get(Number(id))
          // AnkiConnect 的 cardsInfo 行里 note id 字段名是 note（非 noteId）
          return noteId !== undefined && this.notes.has(noteId) ? { cardId: Number(id), note: noteId } : null
        }).filter(Boolean)
      case 'cardReviews': {
        const mmin = Number(params.mmin)
        const mmax = Number(params.mmax)
        return this.reviews.filter(r => r[0]! > mmin && r[0]! <= mmax)
      }
      default: throw new Error(`fake anki: unknown action ${action}`)
    }
  }

  /** 模拟学习者在 Anki 里作答（button 1–4）。 */
  answer(noteKey: string, button: number, tsMs: number, timeMs = 5000): void {
    const note = [...this.notes.values()].find(n => n.fields['来源'] === noteKey)
    if (!note) throw new Error(`fake anki: no note ${noteKey}`)
    const cardId = [...this.cards].find(([, nid]) => nid === note.noteId)?.[0]
    if (cardId === undefined) throw new Error('fake anki: no card')
    this.reviews.push([tsMs, cardId, 0, button, 0, 0, button, timeMs, 1])
  }

  noteFields(noteKey: string): Record<string, string> {
    const note = [...this.notes.values()].find(n => n.fields['来源'] === noteKey)
    if (!note) throw new Error(`fake anki: no note ${noteKey}`)
    return note.fields
  }
}
