export default function ThinkingBlock({ text, truncated = false }: { text: string; truncated?: boolean }) {
  if (!text) return null;
  return <details className="message-thinking">
    <summary>思考过程</summary>
    <pre>{text}</pre>
    {truncated && <p className="muted">实时预览仅显示末尾部分，完成后可查看完整内容。</p>}
  </details>;
}
