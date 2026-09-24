export default function DunnartMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <rect width="64" height="64" rx="16" fill="#3a5a40" />
      <path d="M40 13v38M40 39a13 13 0 1 1 0-15" stroke="#fffdf6" strokeWidth="6" strokeLinecap="round" />
      <circle cx="49" cy="15" r="5" fill="#d9a419" />
    </svg>
  )
}
