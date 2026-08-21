import { useEffect } from 'react';
import { projectStore } from '@/store/projectStore';
import { phraseById } from '@/engine/phrases';

/**
 * Close the phrase editor when the phrase it is editing stops existing.
 *
 * Undo is the reason this cannot be left to the actions that remove a phrase. An undo
 * puts a whole `project` back without going through any of them, so `Make Unique`
 * followed by Ctrl+Z takes the copy away while `editingPhraseId` still names it —
 * leaving the timeline pointed at nothing and every edit silently dropped. The same
 * happens when a phrase is deleted from the arrangement while open.
 *
 * A hook rather than a few lines in `App` so the rule can be tested without mounting
 * the whole application, and it mirrors the instrument re-homing beside it there.
 */
export function usePhraseEditorGuard(): void {
  const project = projectStore(s => s.project);
  const editingPhraseId = projectStore(s => s.editingPhraseId);
  const closePhrase = projectStore(s => s.closePhrase);

  const editingPhrase =
    project && editingPhraseId ? phraseById(project.phrases, editingPhraseId) : null;

  useEffect(() => {
    if (editingPhraseId && !editingPhrase) closePhrase();
  }, [editingPhraseId, editingPhrase, closePhrase]);
}
