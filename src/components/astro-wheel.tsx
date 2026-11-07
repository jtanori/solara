type AstroWheelProps = { className?: string; label?: string };

export function AstroWheel({ className = "", label = "Decorative astrological wheel" }: AstroWheelProps) {
  const signs = ["♈", "♉", "♊", "♋", "♌", "♍", "♎", "♏", "♐", "♑", "♒", "♓"];
  const points = [12, 76, 132, 190, 230, 272, 315].map((angle) => {
    const a = (angle - 90) * Math.PI / 180;
    return [160 + 85 * Math.cos(a), 160 + 85 * Math.sin(a)];
  });
  const chords = [[0, 3], [0, 4], [1, 4], [1, 5], [2, 5], [2, 6], [3, 6], [0, 2], [3, 5], [1, 6], [2, 4]];
  return (
    <svg className={className} viewBox="0 0 320 320" role="img" aria-label={label}>
      <circle cx="160" cy="160" r="151" fill="#fbfaf5" stroke="#8f897d" strokeWidth="0.8" />
      <circle cx="160" cy="160" r="124" fill="none" stroke="#aaa598" strokeWidth="0.65" />
      <circle cx="160" cy="160" r="111" fill="none" stroke="#b9b3a7" strokeWidth="0.55" />
      <circle cx="160" cy="160" r="93" fill="none" stroke="#c7c0b4" strokeWidth="0.55" />
      {Array.from({ length: 72 }, (_, i) => {
        const angle = i * 5 * Math.PI / 180;
        const inner = i % 6 === 0 ? 124 : 128;
        return <line key={`tick-${i}`} x1={160 + inner * Math.cos(angle)} y1={160 + inner * Math.sin(angle)} x2={160 + 131 * Math.cos(angle)} y2={160 + 131 * Math.sin(angle)} stroke="#a39b8e" strokeWidth="0.55" />;
      })}
      {signs.map((sign, i) => {
        const angle = (i * 30 - 75) * Math.PI / 180;
        const division = (i * 30 - 90) * Math.PI / 180;
        return <g key={sign}><line x1={160 + 125 * Math.cos(division)} y1={160 + 125 * Math.sin(division)} x2={160 + 151 * Math.cos(division)} y2={160 + 151 * Math.sin(division)} stroke="#a8a195" strokeWidth="0.65" /><text x={160 + 138 * Math.cos(angle)} y={165 + 138 * Math.sin(angle)} textAnchor="middle" fill={i % 3 === 0 ? "#a74e35" : i % 3 === 1 ? "#526c68" : "#7b6a5e"} fontSize="15" fontFamily="Georgia, serif">{sign}</text></g>;
      })}
      {chords.map(([a, b], i) => <line key={`chord-${i}`} x1={points[a][0]} y1={points[a][1]} x2={points[b][0]} y2={points[b][1]} stroke={i % 2 ? "#a86658" : "#7a9290"} strokeWidth="0.75" opacity="0.75" />)}
      {points.map(([x, y], i) => <g key={`point-${i}`}><circle cx={x} cy={y} r="2.2" fill="#947d6f" /><text x={x + 5} y={y - 4} fontSize="8" fill="#837469">{["☉", "☽", "☿", "♀", "♂", "♃", "♄"][i]}</text></g>)}
      <circle cx="160" cy="160" r="26" fill="#fbfaf5" stroke="#a39b8e" strokeWidth="0.6" />
      <circle cx="160" cy="160" r="15" fill="none" stroke="#b7a99a" strokeWidth="0.6" />
      {Array.from({ length: 8 }, (_, i) => <line key={`ray-${i}`} x1="160" y1="140" x2="160" y2="180" stroke="#a76950" strokeWidth="0.65" transform={`rotate(${i * 22.5} 160 160)`} />)}
      <circle cx="160" cy="160" r="4" fill="#ad634a" />
    </svg>
  );
}
