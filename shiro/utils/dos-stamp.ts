/** MS-DOS date/time fields as stored in ZIP headers (local time, 2-second resolution, years from 1980). */
export function dosStamp(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  const y = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
