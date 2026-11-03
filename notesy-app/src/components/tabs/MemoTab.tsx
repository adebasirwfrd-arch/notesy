import { Clock3 } from "lucide-react";
import { MarkdownEditor } from "../Editor";
import { updateNote } from "../../lib/db";
import { getElapsed } from "../../lib/session";
import { formatClock } from "../../lib/util";
import type { Note } from "../../lib/types";

export function MemoTab({ note, isLive }: { note: Note; isLive: boolean }) {
  const save = (md: string) =>
    updateNote(note.id, (n) => {
      n.memo = md;
    });
  return (
    <div className="memo-tab">
      {isLive && (
        <button
          className="btn btn-small btn-ghost stamp"
          onClick={() => save(`${note.memo.trimEnd()}\n\n**[${formatClock(getElapsed())}]** `.trimStart())}
          title="Sisipkan penanda waktu"
        >
          <Clock3 size={14} /> Tandai waktu
        </button>
      )}
      <MarkdownEditor
        markdown={note.memo}
        onChange={save}
        placeholder={isLive ? "Catat poin penting selama rapat… AI akan memprioritaskan catatan ini." : "Catatan pribadi Anda tentang rapat ini…"}
      />
    </div>
  );
}
