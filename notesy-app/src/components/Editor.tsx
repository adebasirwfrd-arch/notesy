import { useEffect, useRef, useState } from "react";
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { Markdown } from "tiptap-markdown";
import { getSlide } from "../lib/db";
import { useBlobUrl } from "../lib/hooks";
import { formatClock } from "../lib/util";

function SlideImageView({ node, selected }: NodeViewProps) {
  const src = String(node.attrs.src ?? "");
  const alt = String(node.attrs.alt ?? "");
  const slideId = src.startsWith("slide:") ? src.slice(6) : null;
  const [blobKey, setBlobKey] = useState<string | null>(null);
  const [t, setT] = useState<number | null>(null);
  useEffect(() => {
    if (!slideId) return;
    getSlide(slideId).then((s) => {
      setBlobKey(s?.blobKey ?? null);
      setT(s ? s.t : null);
    });
  }, [slideId]);
  const url = useBlobUrl(blobKey);
  const shown = slideId ? url : src;
  return (
    <NodeViewWrapper as="figure" className={`slide-figure${selected ? " is-selected" : ""}`} data-drag-handle>
      {shown ? <img src={shown} alt={alt} draggable={false} /> : <div className="slide-missing">Gambar tidak tersedia</div>}
      {(alt || t !== null) && (
        <figcaption>
          {t !== null && <span className="slide-time">{formatClock(t)}</span>}
          {alt}
        </figcaption>
      )}
    </NodeViewWrapper>
  );
}

const SlideImage = Image.extend({
  addNodeView() {
    return ReactNodeViewRenderer(SlideImageView);
  },
}).configure({ inline: false, allowBase64: true });

interface Props {
  markdown: string;
  onChange?: (md: string) => void;
  editable?: boolean;
  placeholder?: string;
  className?: string;
}

export function MarkdownEditor({ markdown, onChange, editable = true, placeholder, className }: Props) {
  const lastEmitted = useRef(markdown);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
      SlideImage,
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Placeholder.configure({ placeholder: placeholder ?? "Tulis sesuatu…" }),
      Markdown.configure({ html: false, tightLists: true, linkify: true, breaks: false, transformPastedText: true }),
    ],
    content: markdown,
    editable,
    editorProps: { attributes: { class: `prose ${className ?? ""}` } },
    onUpdate: ({ editor: ed }) => {
      if (!onChange) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const md = (ed.storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown();
        lastEmitted.current = md;
        onChange(md);
      }, 400);
    },
  });

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => {
    if (!editor || markdown === lastEmitted.current) return;
    lastEmitted.current = markdown;
    const { from, to } = editor.state.selection;
    editor.commands.setContent(markdown, { emitUpdate: false });
    if (editor.isFocused) editor.commands.setTextSelection({ from: Math.min(from, editor.state.doc.content.size), to: Math.min(to, editor.state.doc.content.size) });
  }, [editor, markdown]);

  useEffect(() => () => clearTimeout(timer.current), []);

  return <EditorContent editor={editor} className="editor" />;
}
