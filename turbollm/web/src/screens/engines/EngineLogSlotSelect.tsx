/** Which engine's log the log views show: the primary (value '') or a loaded pool slot (keep-N, embedding, Laya),
 *  named by its model key. Rendered only while a slot exists, so a one-model setup sees no new control. */
export function EngineLogSlotSelect({
  slots,
  value,
  onChange,
}: {
  slots: string[]
  value: string
  onChange: (model: string) => void
}) {
  if (slots.length === 0) return null
  return (
    <select
      aria-label="Log source"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="max-w-[14rem] truncate rounded-md border border-border bg-bg px-2 py-1 text-[12px] text-ink outline-none"
    >
      <option value="">Primary engine</option>
      {slots.map((key) => (
        <option key={key} value={key}>
          {key}
        </option>
      ))}
    </select>
  )
}
