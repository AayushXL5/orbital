// Calendar export: passes as events with an alarm, for any calendar app.

const stamp = (t) => new Date(t * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const escape = (s) => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

// events: [{uid, start, end, title, description, alarmMinutes}]
export function toIcs(events, name = "Orbital passes") {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Orbital//Passes//EN", "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escape(name)}`];
  const now = stamp(Date.now() / 1000);
  for (const e of events) {
    lines.push("BEGIN:VEVENT", `UID:${e.uid}`, `DTSTAMP:${now}`, `DTSTART:${stamp(e.start)}`,
      `DTEND:${stamp(e.end)}`, `SUMMARY:${escape(e.title)}`, `DESCRIPTION:${escape(e.description)}`);
    if (e.alarmMinutes) {
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escape(e.title)}`,
        `TRIGGER:-PT${e.alarmMinutes}M`, "END:VALARM");
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

export function download(filename, text, type = "text/calendar") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
